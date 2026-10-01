/**
 * Ctrl+wheel is ours only when the note can zoom. `pinch` refuses a
 * start while the note is busy (loading, a non-ink tool, a locked frame), so a
 * wheel event prevented before that refusal is eaten with no zoom and blocks
 * the host's font nudge. The wheel listener asks readiness first and leaves a
 * refused event to the host; a run already under way stays ours.
 */

import { describe, expect, it } from "vitest";

// The overlay reaches for window's timers through winRef; the node test
// environment has no window.
(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { WheelZoomRun } from "./WheelZoom";

function rig(busy: { value: boolean }) {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const phases: string[] = [];
	o.canvasMode = true;
	o.retiring = false;
	o.router = null;
	o.wheelZoomRun = new WheelZoomRun();
	o.getNoteViewportState = () => ({ zoom: 1, busy: busy.value, fitAvailable: !busy.value });
	o.pinch = (phase: string) => { phases.push(phase); };
	o.armWheelZoomQuiet = () => undefined;
	const wheel = (o as unknown as { wheelZoom: (e: WheelEvent) => void }).wheelZoom;
	return {
		phases,
		send(): boolean {
			let prevented = false;
			const e = {
				ctrlKey: true,
				metaKey: false,
				deltaY: -10,
				deltaMode: 0,
				clientX: 100,
				clientY: 100,
				preventDefault: () => { prevented = true; },
				stopPropagation: () => undefined,
			} as unknown as WheelEvent;
			wheel.call(o, e);
			return prevented;
		},
	};
}

describe("ctrl+wheel asks readiness before taking the event", () => {
	it("a busy note leaves the event to the host and starts no run", () => {
		const r = rig({ value: true });
		expect(r.send(), "busy: the host's ctrl+wheel must not be prevented").toBe(false);
		expect(r.phases).toEqual([]);
	});

	it("a ready note takes the event and drives the pinch path", () => {
		const r = rig({ value: false });
		expect(r.send()).toBe(true);
		expect(r.phases[0]).toBe("start");
	});

	it("a run already under way stays ours when the note turns busy", () => {
		const busy = { value: false };
		const r = rig(busy);
		r.send();
		busy.value = true;
		expect(r.send(), "mid-run events are not handed back half way").toBe(true);
	});
});
