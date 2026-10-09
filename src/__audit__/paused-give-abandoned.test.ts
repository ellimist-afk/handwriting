/**
 * A zoom ease paused for a pen contact goes on when the contact ends without a lift.
 *
 * A lift's give easing back to the zoom cap is paused when a pen lands (beforePenDown, pausePinchGive) and resumed
 * only by endPenGesture (resumePinchGive). A contact that ends without a lift - strokeAbandoned (window blur, finger
 * ink turned into a pinch) or endLiveGestureForHistory (undo with the pen down) - never reaches it, so the preview
 * stays up at the paused past-cap scale until the 10 s measure-hold watchdog (rebasePinch) finishes it, and the note
 * reads busy meanwhile.
 *
 * Rig: an Object.create overlay with the collaborators these teardowns touch stubbed; the real strokeAbandoned,
 * endLiveGestureForHistory and resetGestureState run.
 *
 * Expected: red until a contact that ends without a lift resumes a paused give and replays what the contact deferred.
 */
import { expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "../inline/InkOverlay";

type Fields = Record<string, unknown>;
const noop = () => undefined;

function rig(mode: string): Fields {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const renderer = { clear: noop };
	Object.assign(o, {
		mode,
		builder: null,
		frame: { locked: true, cancel() { (this as { locked: boolean }).locked = false; } },
		clearSnapPreview: noop,
		hidePenCursor: noop,
		hideEraserCursor: noop,
		snapChip: null,
		selection: { clear: noop },
		erasePieces: new Set<string>(),
		selectionDeleteKeys: { reset: noop },
		resizeDeferred: false,
		bandSyncDeferred: false,
		mobileTools: null,
		noteZoomControls: null,
		router: null,
		wet: renderer,
		highlightWet: renderer,
		highlightWetCanvas: { setCssStyles: noop },
		tail: { clearAll: noop, prepareLive: noop },
		cssWidth: 0,
		cssHeight: 0,
		view: { dom: { ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame: noop, setTimeout: () => 1, clearTimeout: noop } } } },
		pinchScaleNow: 8.4,
		pinchGive: { from: 8.6, to: 8, startedAt: 0, raf: 0, centroid: { x: 0, y: 0 }, stepping: false, scrollLeft: 0, scrollTop: 0, paused: true },
	});
	return o;
}

const proto = InkOverlayPlugin.prototype as unknown as Record<string, (this: Fields) => void>;

it("window blur or finger ink turned pinch: a give paused for the contact goes on easing to the cap", () => {
	const o = rig("ink");
	proto.strokeAbandoned!.call(o);
	const give = o.pinchGive as { paused: boolean } | null;
	expect(give === null || give.paused === false, `give after the abandon: ${JSON.stringify(give)}`).toBe(true);
});

it("undo with the pen down mid-erase: a give paused for the contact goes on easing to the cap", () => {
	const o = rig("erase");
	proto.endLiveGestureForHistory!.call(o);
	const give = o.pinchGive as { paused: boolean } | null;
	expect(give === null || give.paused === false, `give after the undo: ${JSON.stringify(give)}`).toBe(true);
});

it("finger ink turned into a pinch by a second finger: a give paused for the contact goes on easing to the cap", () => {
	const o = rig("ink");
	Object.assign(o, { frameTicking: false, frameTickToken: null, frameRaf: 0 });
	proto.cancelFingerInkForPinch!.call(o);
	const give = o.pinchGive as { paused: boolean } | null;
	expect(give === null || give.paused === false, `give after the pinch takeover: ${JSON.stringify(give)}`).toBe(true);
});

it("the pinch that ended the finger ink takes the zoom over: the resumed ease is dropped and its frame cancelled", () => {
	const o = rig("ink");
	const cancelled: number[] = [];
	const win = (o.view as { dom: { ownerDocument: { defaultView: Record<string, unknown> } } }).dom.ownerDocument.defaultView;
	win.requestAnimationFrame = () => 7;
	win.cancelAnimationFrame = (id: number) => { cancelled.push(id); };
	Object.assign(o, { frameTicking: false, frameTickToken: null, frameRaf: 0, retiring: false, canvasMode: true, getNoteViewportState: () => ({ busy: true }) });
	proto.cancelFingerInkForPinch!.call(o);
	expect((o.pinchGive as { raf: number } | null)?.raf, "precondition: the ease resumed with a frame queued").toBe(7);
	(InkOverlayPlugin.prototype as unknown as { pinch: (this: Fields, phase: string, ratio: number, c: { x: number; y: number }) => void })
		.pinch.call(o, "start", 1, { x: 0, y: 0 });
	expect(o.pinchGive, "the new pinch owns the zoom").toBeNull();
	expect(cancelled, "the resumed ease's frame is cancelled, so the two do not fight").toEqual([7]);
});

function undoRig(): { o: Fields; scrolls: string[]; resizes: () => number } {
	const o = rig("erase");
	const scrolls: string[] = [];
	let resizes = 0;
	Object.assign(o, {
		pinchGive: null,
		frameTicking: false, frameTickToken: null, frameRaf: 0,
		scheduleRepaint: (via: string) => { scrolls.push(via); },
		replayDeferredResize: () => { resizes++; },
	});
	return { o, scrolls, resizes: () => resizes };
}

it("undo with the pen down replays a band move the contact deferred, as a blur does", () => {
	const { o, scrolls } = undoRig();
	o.bandSyncDeferred = true;
	proto.endLiveGestureForHistory!.call(o);
	expect(scrolls, "the deferred band update runs").toContain("scroll");
});

it("undo with the pen down replays a pane resize the contact deferred, as a blur does", () => {
	const { o, resizes } = undoRig();
	proto.endLiveGestureForHistory!.call(o);
	expect(resizes(), "replayDeferredResize runs once").toBe(1);
});
