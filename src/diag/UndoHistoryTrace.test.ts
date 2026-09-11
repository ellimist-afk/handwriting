import { beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticsEpoch, setDiagnosticsEnabled } from "./DiagSwitch";
import {
	beginUndoWindow,
	captureUndoTrace,
	clearUndoTrace,
	endUndoWindow,
	isUndoRedoKey,
	recordUndoObservation,
	discardUndoTrace,
	registerUndoTraceView,
	queueUndoPostObservation,
	resetUndoTrace,
} from "./UndoHistoryTrace";

const identity = {};
const pre = {
	kind: "undo" as const,
	key: { key: "z" as const, ctrl: true, meta: false, shift: false, alt: false, defaultPrevented: false, target: "editor" as const },
	selection: { from: 4, to: 4, anchor: 4, head: 4, empty: true },
	scroll: { x: 0, y: 700, phase: "before" as const, axes: "y" },
};

describe("UndoHistoryTrace", () => {
	it("schedules and cancels a popout trace on its owning window", () => {
		clearUndoTrace();setDiagnosticsEnabled(true);resetUndoTrace();
		const timers=new Set<number>(),frames=new Set<number>();let next=0;
		const owner={setTimeout:vi.fn(()=>{const id=++next;timers.add(id);return id;}),clearTimeout:vi.fn((id:number)=>timers.delete(id)),requestAnimationFrame:vi.fn(()=>{const id=++next;frames.add(id);return id;}),cancelAnimationFrame:vi.fn((id:number)=>frames.delete(id))};
		const popoutIdentity={};registerUndoTraceView({ownerDocument:{defaultView:owner}},popoutIdentity);
		beginUndoWindow(popoutIdentity,pre);expect(owner.setTimeout).toHaveBeenCalledTimes(2);queueUndoPostObservation(popoutIdentity,diagnosticsEpoch(),()=>({phase:"post"}));
		expect(owner.setTimeout).toHaveBeenCalledTimes(2);expect(owner.requestAnimationFrame).toHaveBeenCalledTimes(1);
		clearUndoTrace();expect(timers.size).toBe(0);expect(frames.size).toBe(0);expect(owner.cancelAnimationFrame).toHaveBeenCalledTimes(1);
	});
	beforeEach(() => {
		vi.useRealTimers();
		setDiagnosticsEnabled(false);
		clearUndoTrace();
	});

	it("accepts supported gestures and keeps request separate from observed restore", () => {
		expect(isUndoRedoKey({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false })).toBe("undo");
		expect(isUndoRedoKey({ key: "z", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false })).toBe("redo");
		expect(isUndoRedoKey({ key: "y", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: false })).toBe("redo");
		expect(isUndoRedoKey({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, repeat: true })).toBeNull();
		setDiagnosticsEnabled(true);
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		recordUndoObservation(identity, { phase: "transaction", transaction: { sequence: 1, count: 1, userEvent: "undo", docChanged: false, inkEffectCount: 1, foreignEffectCount: 0 }, guard: { decision: "restore", stage: "request", reason: "effect-only-history" } });
		recordUndoObservation(identity, { phase: "post", guard: { decision: "restore", stage: "observed", reason: "effect-only-history" }, scroll: { x: 0, y: 700, phase: "after", axes: "" } });
		const trace = captureUndoTrace();
		expect(trace.status).toBe("captured");
		expect(trace.gestures).toBe(1);
		expect(trace.records.find((r) => r.guard?.stage === "request")?.guard?.stage).toBe("request");
		expect(trace.records.find((r) => r.guard?.stage === "observed")?.guard?.stage).toBe("observed");
	});

	it("bounds gestures and discards stale identities", () => {
		setDiagnosticsEnabled(true);
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		beginUndoWindow(identity, { ...pre, kind: "redo" });
		beginUndoWindow(identity, pre);
		expect(captureUndoTrace().truncated).toBe(true);
		const other = {};
		beginUndoWindow(other, pre);
		expect(captureUndoTrace().status).toBe("discarded");
		expect(captureUndoTrace().endReason).toBe("identity-change");
	});

	it("uses one quiet timer and does nothing while recording is off", () => {
		const timer = vi.spyOn(globalThis, "setTimeout");
		beginUndoWindow(identity, pre);
		expect(timer).not.toHaveBeenCalled();
		setDiagnosticsEnabled(true);
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		expect(timer).toHaveBeenCalledTimes(2);
		endUndoWindow("recording-stopped");
		clearUndoTrace();
		timer.mockRestore();
	});

	it("quiet and hard-deadline timers close the retained snapshot", () => {
		vi.useFakeTimers();
		setDiagnosticsEnabled(true);
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		vi.advanceTimersByTime(250);
		expect(captureUndoTrace().endReason).toBe("quiet");
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		for (let i = 0; i < 9; i++) {
			vi.advanceTimersByTime(200);
			recordUndoObservation(identity, { phase: "transaction" });
		}
		vi.advanceTimersByTime(200);
		expect(captureUndoTrace().endReason).toBe("hard-deadline");
	});

	it("retains prior quiet-window records and preserves a stopped capture", () => {
		vi.useFakeTimers();
		setDiagnosticsEnabled(true);
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		recordUndoObservation(identity, { phase: "transaction" });
		vi.advanceTimersByTime(250);
		beginUndoWindow(identity, { ...pre, kind: "redo" });
		expect(captureUndoTrace().records.length).toBeGreaterThan(1);
		recordUndoObservation(identity, { phase: "transaction" });
		const times = captureUndoTrace().records.map((record) => record.t);
		expect(times[times.length - 1] ?? 0).toBeGreaterThanOrEqual(times[0] ?? 0);
		expect(times.some((time, index) => index > 0 && time > (times[index - 1] ?? time))).toBe(true);
		vi.advanceTimersByTime(250);
		beginUndoWindow(identity, pre);
		expect(captureUndoTrace().truncated).toBe(true);
		endUndoWindow("recording-stopped");
		discardUndoTrace(identity);
		expect(captureUndoTrace().status).toBe("captured");
	});

	it("reuses an ephemeral view identity across remounts", () => {
		const view = {};
		const first = registerUndoTraceView(view, {});
		const second = registerUndoTraceView(view, {});
		expect(second).toBe(first);
	});

	it("fences old-window deferred reads and does not queue while off", () => {
		const callbacks: Array<FrameRequestCallback> = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		let read = false;
		setDiagnosticsEnabled(true);
		resetUndoTrace();
		beginUndoWindow(identity, pre);
		queueUndoPostObservation(identity, diagnosticsEpoch(), () => { read = true; return { phase: "post" }; });
		endUndoWindow("quiet");
		beginUndoWindow(identity, { ...pre, kind: "redo" });
		callbacks[0]?.(0);
		expect(read).toBe(false);
		setDiagnosticsEnabled(false);
		queueUndoPostObservation(identity, diagnosticsEpoch(), () => { read = true; return { phase: "post" }; });
		expect(read).toBe(false);
		vi.unstubAllGlobals();
	});
});
