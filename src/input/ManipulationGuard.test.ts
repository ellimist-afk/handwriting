import { describe, expect, it } from "vitest";
import { ManipulationGuard } from "./ManipulationGuard";
import { PAROLE_DIST_PX, PAROLE_MAX_CONTACT_PX, paroleEarned } from "./PalmGate";

describe("ManipulationGuard — standing guard for cold pen contacts", () => {
	it("rests ARMED: touch-action none before any pen has ever been seen", () => {
		const g = new ManipulationGuard();
		expect(g.current).toBe("armed");
		expect(g.penSignal().touchAction).toBe("none");
	});

	it("a cold pen contact after long idle meets an armed guard", () => {
		const g = new ManipulationGuard();
		// scrolling happened via wheel — wheel never touches the guard —
		// and the pen strikes with zero hover:
		const d = g.penSignal();
		expect(d.touchAction).toBe("none");
		expect(g.current).toBe("armed");
	});

	it("first finger while armed gets the assist but does NOT drop the guard (v0.12.12)", () => {
		const g = new ManipulationGuard();
		const d = g.touchStart();
		expect(d.touchAction).toBe("none");
		expect(d.assistThisGesture).toBe(true);
		expect(g.current).toBe("armed-assist");
	});

	it("THE COLD-SLAM FIX: palm grazes first, pen strikes mid-gesture — guard never dropped", () => {
		// Cold approach: hand edge reaches the glass before the tip, no hover
		// in the last 300 ms so the palm gate could not block it.
		const g = new ManipulationGuard();
		const palm = g.touchStart();
		expect(palm.touchAction).toBe("none"); // v0.12.10 returned "" here — the hole
		// Pen tip lands milliseconds later: still a committed touch-action: none.
		const pen = g.penSignal();
		expect(pen.touchAction).toBe("none");
		expect(g.current).toBe("armed");
		// The palm lifts after the stroke: still armed, no window, no timer.
		const lift = g.touchEnd(false);
		expect(lift.touchAction).toBe("none");
		expect(lift.scheduleRearm).toBe(false);
		expect(g.current).toBe("armed");
	});

	it("a tap (or resting palm) that lifts without panning never opens the window", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		const d = g.touchEnd(false);
		expect(d.touchAction).toBe("none");
		expect(d.scheduleRearm).toBe(false);
		expect(g.current).toBe("armed");
	});

	it("a real finger pan opens the window only when the last finger LIFTS", () => {
		const g = new ManipulationGuard();
		const start = g.touchStart();
		expect(start.touchAction).toBe("none"); // guarded for the whole gesture
		const d = g.touchEnd(true); // assist engaged: this was a scroll
		expect(d.touchAction).toBe("");
		expect(d.scheduleRearm).toBe(true);
		expect(g.current).toBe("touch-linger");
	});

	it("subsequent finger gestures inside the window are native (no assist)", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		g.touchEnd(true); // window opens, re-arm scheduled
		const d = g.touchStart(); // second gesture arrives before re-arm fires
		expect(d.assistThisGesture).toBe(false);
		expect(d.touchAction).toBe("");
		expect(d.cancelRearm).toBe(true);
		expect(g.current).toBe("touch-open");
	});

	it("a second simultaneous finger never gets its own assist", () => {
		const g = new ManipulationGuard();
		expect(g.touchStart().assistThisGesture).toBe(true);
		expect(g.touchStart().assistThisGesture).toBe(false);
	});

	it("multi-finger: nothing changes until the LAST finger lifts", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		g.touchStart();
		const first = g.touchEnd(true);
		expect(first.scheduleRearm).toBe(false);
		expect(first.touchAction).toBe("none"); // still mid-gesture, still guarded
		const last = g.touchEnd(true);
		expect(last.scheduleRearm).toBe(true);
		expect(last.touchAction).toBe("");
		expect(g.current).toBe("touch-linger");
	});

	it("the re-arm timer restores none", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		g.touchEnd(true);
		const d = g.rearm();
		expect(d.touchAction).toBe("none");
		expect(g.current).toBe("armed");
	});

	it("a stale re-arm fire is a no-op outside the linger state", () => {
		const g = new ManipulationGuard();
		g.touchStart(); // armed-assist: no timer should exist, but fire one anyway
		const d = g.rearm();
		expect(g.current).toBe("armed-assist");
		expect(d.touchAction).toBe("none");
	});

	it("pen hover during the linger re-arms instantly and cancels the timer", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		g.touchEnd(true);
		const d = g.penSignal();
		expect(d.touchAction).toBe("none");
		expect(d.cancelRearm).toBe(true);
		expect(g.current).toBe("armed");
	});

	it("pen signal inside the native window arms (palm gate owns the touches by then)", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		g.touchEnd(true);
		g.touchStart(); // native gesture in the window
		const d = g.penSignal();
		expect(d.touchAction).toBe("none");
		expect(g.current).toBe("armed");
	});

	it("native-window gesture opens the linger again on lift even without assist", () => {
		const g = new ManipulationGuard();
		g.touchStart();
		g.touchEnd(true);
		g.touchStart(); // native — assist never engages, so panned=false on lift
		const d = g.touchEnd(false);
		expect(d.touchAction).toBe("");
		expect(d.scheduleRearm).toBe(true);
		expect(g.current).toBe("touch-linger");
	});

	it("hover-first flow stays armed end to end", () => {
		const g = new ManipulationGuard();
		g.penSignal(); // hover
		g.penSignal(); // more hover
		const down = g.penSignal(); // contact
		expect(down.touchAction).toBe("none");
	});
});

describe("paroleEarned — blocked contacts that move like a swipe (v0.13.3)", () => {
	it("a swallowed contact that travels fast earns parole", () => {
		expect(paroleEarned({ travelPx: 30, sinceDownMs: 120, penStrokeActive: false })).toBe(true);
	});

	it("a resting palm never earns parole", () => {
		expect(paroleEarned({ travelPx: 6, sinceDownMs: 350, penStrokeActive: false })).toBe(false);
	});

	it("slow later drift stays palm — the window closes", () => {
		expect(paroleEarned({ travelPx: 40, sinceDownMs: 800, penStrokeActive: false })).toBe(false);
	});

	it("nothing earns parole while a stroke is active", () => {
		expect(paroleEarned({ travelPx: 100, sinceDownMs: 50, penStrokeActive: true })).toBe(false);
	});

	it("threshold is exact", () => {
		expect(paroleEarned({ travelPx: PAROLE_DIST_PX, sinceDownMs: 100, penStrokeActive: false })).toBe(true);
		expect(paroleEarned({ travelPx: PAROLE_DIST_PX - 1, sinceDownMs: 100, penStrokeActive: false })).toBe(false);
	});

	it("a palm-sized contact never earns parole, however it moves (geometry veto)", () => {
		expect(
			paroleEarned({
				travelPx: 200,
				sinceDownMs: 100,
				penStrokeActive: false,
				contactPx: PAROLE_MAX_CONTACT_PX + 1,
			})
		).toBe(false);
	});

	it("a contact that landed mid-stroke stays palm after the nib lifts (eraser scrub)", () => {
		// Fast, small, fresh — everything parole looks for — but the stroke it
		// landed under has just ended and the hand is sliding to the next
		// scrub: that slide must not pan the note.
		expect(
			paroleEarned({
				travelPx: 60,
				sinceDownMs: 90,
				penStrokeActive: false,
				contactPx: 12,
				penContactOverlapped: true,
			})
		).toBe(false);
	});

	it("a contact the pen landed ON TOP OF stays palm after the nib lifts", () => {
		// Same flag, other order: the edge re-planted in the gap between
		// scrubs, then the eraser came down over it. Palm for life.
		expect(
			paroleEarned({ travelPx: 100, sinceDownMs: 50, penStrokeActive: false, penContactOverlapped: true })
		).toBe(false);
	});

	it("a contact the pen never overlapped is still judged by motion (pen→scroll feel unchanged)", () => {
		expect(
			paroleEarned({ travelPx: 30, sinceDownMs: 120, penStrokeActive: false, penContactOverlapped: false })
		).toBe(true);
	});

	it("a fingertip-sized or size-unknown contact is judged by motion", () => {
		expect(
			paroleEarned({ travelPx: 30, sinceDownMs: 100, penStrokeActive: false, contactPx: 32 })
		).toBe(true);
		expect(
			paroleEarned({ travelPx: 30, sinceDownMs: 100, penStrokeActive: false, contactPx: 1 })
		).toBe(true);
	});
});
