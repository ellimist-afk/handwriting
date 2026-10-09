import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouter";
import type { PenSample } from "../input/PointerRouter";
import { StrokeBuilder } from "./StrokeBuilder";
import { InkOverlayPlugin } from "../inline/InkOverlay";

// Picture-derived hypothesis, not a replay or measured pointer capture:
// https://github.com/ellimist-afk/handwriting/issues/37
// The final large Q has a gap in its upper curved outline. Construct a curved
// contact whose final pressed samples share a delivery with a later hover.
// Losing those earlier samples truncates the visible arc. The report does not
// establish this event sequence or prove it is the reporter's hardware cause.
const activeId = 23;
const cleanups: Array<() => void> = [];
let previousDiagnostics = false;

beforeEach(() => {
    vi.useFakeTimers();
    previousDiagnostics = diagnosticsEnabled();
    setDiagnosticsEnabled(true);
    clearInlinePenTrace();
    cleanups.push(installFakeWindow());
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    clearInlinePenTrace();
    setDiagnosticsEnabled(previousDiagnostics);
    vi.clearAllTimers();
    vi.useRealTimers();
});

function event(type: string, timestamp: number, x: number, y: number, pressure = 0.3, buttons = 1, pointerId = activeId): PointerEvent {
    return Object.assign(penEvent(type, timestamp, { x, y, pressure, buttons, pointerId }), {
        button: type === "pointerdown" || type === "pointerup" ? 0 : -1,
    });
}

function route() {
    const h = harness();
    cleanups.push(() => h.router.dispose());
    let builder: StrokeBuilder | null = null;
    const builderInputs: PenSample[] = [];
    const saved: ReturnType<StrokeBuilder["finishReleaseFiltered"]> = [];
    const down = h.rec.cb.onPenDown;
    const raw = h.rec.cb.onPenRaw;
    const up = h.rec.cb.onPenUp;
    const add = (sample: PenSample) => {
        if (!builder) throw new Error("sample delivered without active builder");
        builderInputs.push({ ...sample });
        builder.add(sample.x, sample.y, sample.pressure, sample.timestamp, sample.tiltX, sample.tiltY);
    };
    h.rec.cb.onPenDown = (sample, ev) => {
        down(sample, ev);
        builder = new StrokeBuilder("pen", "#377dff", 2);
        builder.start(sample.timestamp);
        add(sample);
    };
    h.rec.cb.onPenRaw = (samples, ev) => {
        raw(samples, ev);
        samples.forEach(add);
    };
    h.rec.cb.onPenUp = (ev) => {
        up(ev);
        // Inline pen commits use finishReleaseFiltered, not finish, and do
        // not append the outer pen-up coordinate (InkOverlay's mouse-only path).
        if (!builder) throw new Error("finalization without active builder");
        saved.push(...builder.finishReleaseFiltered());
        builder = null;
    };
    return { ...h, saved, builderInputs };
}

function startArc(h: ReturnType<typeof route>, channel: string) {
    h.fire(event("pointerdown", 1000, 100, 100));
    h.fire(event(channel, 1006, 102, 97));
    expect(h.rec.downs).toBe(1);
    expect(h.rec.rawCalls.flat()).toHaveLength(1);
    expect(formatInlinePenTrace()).toContain("CLAIMED");
}

describe("issue 37: constructed public-route arc interruption", () => {
    it("does not feed the same coalesced batch twice across raw then move", () => {
        const h = route();
        startArc(h, "pointerrawupdate");
        const shared = [event("pointerrawupdate", 1010, 104, 95), event("pointerrawupdate", 1016, 107, 94)];
        const raw = event("pointerrawupdate", 1016, 107, 94);
        const move = event("pointermove", 1024, 112, 92, 0, 0);
        Object.assign(raw, { getCoalescedEvents: () => shared });
        Object.assign(move, { getCoalescedEvents: () => shared });
        h.fire(raw);
        expect(h.builderInputs.map(p => [p.timestamp, p.x, p.y]), "raw contact must reach the real builder before lift").toEqual([
            [1000, 100, 100], [1006, 102, 97], [1010, 104, 95], [1016, 107, 94],
        ]);
        for (const contact of shared) expect(h.builderInputs.filter(p => p.timestamp === contact.timeStamp)).toHaveLength(1);
        expect(h.rec.ups).toBe(0);
        const beforeMove = h.builderInputs.map(p => ({ ...p }));
        h.fire(move);
        expect(h.builderInputs, "shared coalesced contacts must not enter the builder twice").toEqual(beforeMove);
        for (const contact of shared) expect(h.builderInputs.filter(p => p.timestamp === contact.timeStamp)).toHaveLength(1);
        expect(h.rec.ups).toBe(1);
        expect(h.saved).toHaveLength(1);
        expect(h.saved[0]!.points.map(p => [p.x, p.y])).toEqual([
            [100, 100], [102, 97], [104, 95], [107, 94],
        ]);
        h.fire(event("pointerup", 1030, 112, 92, 0, 0));
        expect(h.rec.ups).toBe(1);
        expect(h.saved).toHaveLength(1);
    });

    it.each(["pointerrawupdate", "pointermove"])("%s pans only to recovered contact before a distant hover lift", (channel) => {
        const h = harness();
        cleanups.push(() => h.router.dispose());
        const scrollDOM = { scrollLeft: 300, scrollTop: 400 };
        const overlay = Object.assign(Object.create(InkOverlayPlugin.prototype), {
            mode: "pan", panLast: { x: 100, y: 100 }, view: { scrollDOM },
        }) as { penRaw(samples: PenSample[], ev: PointerEvent): void };
        const raw = h.rec.cb.onPenRaw;
        const up = h.rec.cb.onPenUp;
        let terminal: PointerEvent | undefined;
        h.rec.cb.onPenRaw = (samples, ev) => { raw(samples, ev); overlay.penRaw(samples, ev); };
        h.rec.cb.onPenUp = (ev) => { terminal = ev; up(ev); };
        h.fire(event("pointerdown", 1000, 100, 100));
        h.fire(event(channel, 1006, 100, 100));
        const contact = event(channel, 1010, 110, 110);
        const lift = event(channel, 1020, 200, 200, 0, 0);
        Object.assign(lift, { getCoalescedEvents: () => [contact, lift] });
        h.fire(lift);
        expect(scrollDOM, "pan must stop at the last accepted contact, not the hover position").toEqual({ scrollLeft: 290, scrollTop: 390 });
        expect(terminal).toBe(lift);
        expect(h.rec.ups).toBe(1);
        h.fire(event("pointerup", 1026, 200, 200, 0, 0));
        expect(h.rec.ups).toBe(1);
    });

    it.each(["pointerrawupdate", "pointermove"])("%s keeps pressed coalesced arc samples before the enclosing silent lift", (channel) => {
        const h = route();
        startArc(h, channel);
        const pressed = [event(channel, 1010, 104, 95), event(channel, 1016, 107, 94)];
        const lift = event(channel, 1024, 112, 92, 0, 0);
        Object.assign(lift, { getCoalescedEvents: () => [...pressed, lift] });
        expect(pressed.map(e => [e.pointerId, e.button, e.buttons, e.pressure])).toEqual([
            [activeId, -1, 1, 0.3], [activeId, -1, 1, 0.3],
        ]);
        h.fire(lift);
        expect(h.rec.ups).toBe(1);
        expect(h.saved).toHaveLength(1);
        expect(h.saved[0]!.points.map(p => [p.x, p.y]), "Q arc must include accepted pre-lift points").toEqual([
            [100, 100], [102, 97], [104, 95], [107, 94],
        ]);
        h.fire(event("pointerup", 1030, 112, 92, 0, 0));
        expect(h.rec.ups).toBe(1);
    });

    it.each(["pointerrawupdate", "pointermove"])("%s keeps ordinary contact and a pressure dip continuous", (channel) => {
        const h = route();
        startArc(h, channel);
        h.fire(event(channel, 1010, 104, 95, 0.01));
        h.fire(event(channel, 1016, 107, 94, 0.01));
        h.fire(event(channel, 1022, 110, 95));
        expect(h.rec.ups).toBe(0);
        h.fire(event("pointerup", 1030, 110, 95, 0, 0));
        expect(h.rec.ups).toBe(1);
        expect(h.saved).toHaveLength(1);
        expect(h.saved[0]!.points.map(p => p.x)).toEqual([100, 102, 104, 107, 110]);
    });

    it.each(["pointercancel", "lostpointercapture"])("real %s finalizes once and never resumes contact", (terminal) => {
        const h = route();
        startArc(h, "pointerrawupdate");
        h.fire(event(terminal, 1010, 102, 97, 0, 0));
        h.fire(event("pointerrawupdate", 1016, 107, 94));
        h.fire(event("pointerup", 1020, 107, 94, 0, 0));
        expect(h.rec.ups).toBe(1);
        expect(h.rec.rawCalls.flat()).toHaveLength(1);
        expect(h.saved).toHaveLength(1);
    });

    it("wrong pointer at equal timestamp neither feeds nor terminates the active contact", () => {
        const h = route();
        startArc(h, "pointerrawupdate");
        const other = event("pointerrawupdate", 1010, 999, 999, 0, 0, 41);
        const own = event("pointerrawupdate", 1010, 104, 95);
        expect([other.pointerId, own.pointerId]).toEqual([41, activeId]);
        h.fire(other);
        h.fire(own);
        expect(h.rec.ups).toBe(0);
        h.fire(event("pointerup", 1020, 104, 95, 0, 0));
        expect(h.saved[0]!.points.map(p => p.x)).toEqual([100, 102, 104]);
    });

    it("hover does not claim contact, and a later down can reacquire after genuine silent lift", () => {
        const h = route();
        h.fire(event("pointerrawupdate", 990, 98, 102, 0, 0));
        expect(h.rec.downs).toBe(0);
        startArc(h, "pointerrawupdate");
        h.fire(event("pointerrawupdate", 1010, 104, 95, 0, 0));
        expect(h.rec.ups).toBe(1);
        h.fire(event("pointerdown", 1020, 110, 95));
        h.fire(event("gotpointercapture", 1021, 110, 95));
        h.fire(event("pointerrawupdate", 1026, 114, 98));
        h.fire(event("pointerup", 1030, 114, 98, 0, 0));
        expect(h.rec.downs).toBe(2);
        expect(h.rec.ups).toBe(2);
        expect(h.saved).toHaveLength(2);
    });
});
