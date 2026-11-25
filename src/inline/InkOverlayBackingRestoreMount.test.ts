/**
 * The restore listeners, put on by the real mount: a wiring guard for the canvas-given-back fix.
 *
 * The cells in `InkOverlayBackingRestore.test.ts` open the repaint rig, which calls the watch itself in place of mount, so
 * they stay green with mount's own call gone. This file builds a real overlay and runs `mount()` to its last line
 * (`mountRig.test.util.ts`), records every listener put on an element while it runs, and asks what production did: one
 * `contextrestored` listener on each canvas the overlay paints, and that listener the restore's own (it marks the backings
 * lost and asks the restore frame). It does not prove the browser sends the event; the repaint rig's cells show what the pass
 * does once it runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MountedOverlay, RigEl, RigWin, mountOverlay } from "./mountRig.test.util";

type Listener = { el: unknown; type: string; fn: () => void };

/** Every listener added to a rig element from here on, in order. The rig's own add does nothing, so nothing else changes. */
function recordListeners(): Listener[] {
	const seen: Listener[] = [];
	vi.spyOn(RigEl.prototype, "addEventListener").mockImplementation(function (this: RigEl, ...a: unknown[]) {
		seen.push({ el: this, type: String(a[0]), fn: a[1] as () => void });
	});
	return seen;
}

let m: MountedOverlay | null = null;

afterEach(() => {
	m?.destroy();
	m = null;
	vi.restoreAllMocks();
});

describe("the restore listeners, put on by the real mount", () => {
	it("mount puts one contextrestored listener on each canvas the overlay paints, and it asks the restore frame", () => {
		// Defect: mount no longer calls the watch (the call dropped or moved past an early return), so no canvas has a listener
		// and a canvas the browser gives back blank stays blank until a zoom or a note switch, with every repaint-rig cell green.
		const seen = recordListeners();
		m = mountOverlay("Notes/restore.md");
		const o = m.o;
		const layer = o.attachedLayer as { pen?: unknown; hl?: unknown } | null | undefined;
		const canvases = [
			o.highlightCanvas,
			o.highlightWetCanvas,
			o.committedCanvas,
			o.wetCanvas,
			o.wetTileCanvas,
			o.tailCanvas,
			layer?.pen,
			layer?.hl,
		].filter((c) => !!c);
		expect(canvases.length, "precondition: mount built the six canvases it always paints").toBeGreaterThanOrEqual(6);
		const restored = seen.filter((l) => l.type === "contextrestored");
		expect(canvases.map((c) => restored.filter((l) => l.el === c).length), "one listener on each canvas").toEqual(canvases.map(() => 1));
		expect(restored.length, "on no other element").toBe(canvases.length);
		// contextlost is not taken: cancelling it would stop the browser restoring the canvas.
		expect(seen.filter((l) => l.type === "contextlost")).toEqual([]);
		// The listener is the restore's: it marks the backings lost and asks one frame.
		const win = o.winRef as RigWin;
		const frames = win.frames.length;
		restored[0]!.fn();
		expect(o.backingRestored, "the backings marked lost").toBe(true);
		expect(win.frames.length, "one restore frame asked").toBe(frames + 1);
	});
});
