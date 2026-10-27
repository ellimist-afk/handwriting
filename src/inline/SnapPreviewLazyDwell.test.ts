import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SnapPreview } from "./SnapPreview";
import { StrokeBuilder } from "../ink/StrokeBuilder";

// The dwell runs on one timer that re-arms for the rest when a move came since it was set, instead of a timer replaced
// per move. These hold what that must never change: a pen in motion sets one timer per dwell, not one per move, the
// shape shows exactly 350 ms after the last meaningful move, and a lift or commit before then leaves nothing to show.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function rig() {
	const builder = new StrokeBuilder("pen", "#112233", 2);
	builder.start(0);
	for (let i = 0; i < 16; i++) builder.add(i * 8, i % 2, 0.5, i * 8);
	const setTimer = vi.fn((fn: TimerHandler, ms?: number) => setTimeout(fn as () => void, ms) as unknown as number);
	const show = vi.fn(() => true);
	const p = new SnapPreview({ clock: { setTimeout: setTimer, clearTimeout: (id: number) => clearTimeout(id) }, valid: () => true,
		snapshot: () => builder.snapshotReleaseFiltered(), show, hide: () => undefined });
	p.start(120, 1);
	return { p, builder, setTimer, show };
}

it("a lift or commit at 300 ms leaves nothing for the timer to show at 350 ms", () => {
	const r = rig();
	vi.advanceTimersByTime(300);
	r.p.clear();
	vi.advanceTimersByTime(50);
	vi.advanceTimersByTime(1000);
	expect(r.show).not.toHaveBeenCalled();
});

it("a lift at 300 ms after a move leaves nothing for the re-armed timer either", () => {
	const r = rig();
	vi.advanceTimersByTime(200);
	r.p.move(140, 1);
	vi.advanceTimersByTime(100);
	expect(r.p.take(r.builder.finishReleaseFiltered(), true)).toBeNull();
	vi.advanceTimersByTime(1000);
	expect(r.show).not.toHaveBeenCalled();
});

it("moving for a second sets one timer per dwell, and the shape shows 350 ms after the last move, never earlier", () => {
	const r = rig();
	for (let i = 0; i < 100; i++) { vi.advanceTimersByTime(10); r.p.move(130 + i * 8, 1); }
	expect(r.setTimer.mock.calls.length).toBeLessThanOrEqual(5);
	vi.advanceTimersByTime(349);
	expect(r.show).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(r.show).toHaveBeenCalledTimes(1);
});
