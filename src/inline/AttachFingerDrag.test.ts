/**
 * A finger moves the selection (the Attach rethink, commit B). A lone finger landing on the selection (its padded box,
 * a handle, the Attach button or a pin) is held by the router: nothing claims it at the down, no ink, no pan, no lasso.
 * Past the router's own tap limit (TAP_MAX_MOVE_PX) the selection claims it from where it landed, so the box moves by
 * the whole delta; a lift inside the limit is today's tap. A second finger, a palm, a palm-sized contact and a
 * pointercancel each leave the box where it started.
 *
 * The real InlinePenRouter on a fake scroller, wired to the bare overlay of attachTapRig.test.util.ts: claimTouch is the
 * overlay's selectionContactAt, as InkOverlayLifecycle wires it; onPenDown the overlay's real penDown; onPenRaw the lasso
 * move (penRaw's lasso branch); onPenUp the lasso lift, or the real penUp for a pointercancel or no event (a pen
 * landing while the finger holds the contact: the router's commitFingerInkForPenPreemption).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InlinePenRouter } from "./InlinePenRouter";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { TAP_MAX_MOVE_PX } from "../input/PointerRouter";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { doc, line, noteStrokes, tapRig, type RigOpts } from "./attachTapRig.test.util";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";
import { attachPinsOf } from "./AttachDecoration";
import { attachButtonPoint } from "./LassoTransform";
import { SELECTION_GRAB_PAD } from "./InkOverlayConstants";
import { setTipMode } from "./TipMode";

type Bounds = { x: number; y: number; width: number; height: number };

let restore: () => void;
beforeAll(() => {
	restore = installFakeWindow();
});
afterAll(() => restore());

const G1 = ["c1", "c2"];
/** The free line moved up to line 7, inside the fake scroller's 600 px: x 10..170 at y 260. */
const FREE = { x: 90, y: 260 };
/** Inside g1's ring, clear of its strokes (AttachFingerSelect's IN_G1_CIRCLE). */
const IN_G1 = { x: 150, y: 96 };

function dragRig(path: string, opts: RigOpts = {}) {
	const strokes = noteStrokes().map((s) => (s.id === "free" ? line("free", 10, 260, 160) : s));
	const r = tapRig(path, { strokes, ...opts });
	Object.assign((r.overlay as unknown as { view: object }).view, {
		scaleY: 1,
		hasFocus: true,
		focus: () => {},
		lineBlockAt: () => ({ top: 80, bottom: 120 }),
		lineBlockAtHeight: (h: number) => {
			const l = doc.line(Math.max(1, Math.min(doc.lines, Math.floor(h / 40) + 1)));
			return { from: l.from, to: l.to, top: (l.number - 1) * 40, bottom: l.number * 40 };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	});
	const wetDowns: unknown[] = [];
	const wet = { shape: true, beginStroke: (...a: unknown[]) => void wetDowns.push(a), contactHalfWidth: () => 1, clear: () => {} };
	Object.assign(r.overlay, {
		fontZoom: 1,
		followRefAt: () => ({ x: 3, y: 200 }),
		endLiveGestureForHistory: () => {},
		repaintPath: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		// penDown's own reach into the editor, the strip and the probe: none is the subject.
		mode: "ink", router: null, mobileTools: null, penCursorEl: null,
		penStyle: { ...DEFAULT_PEN }, highlighterStyle: { ...DEFAULT_PEN }, wet, highlightWet: wet, predReal: [], predLastTail: [],
		frame: { locked: false, begin: () => {}, end: () => {}, cancel: () => {} },
		syncCamera: () => {}, captureProbeGeometry: () => {}, recordPenDownState: () => {}, startFrameTicker: () => {},
		ensurePenTools: () => {}, probeSample: () => {}, showEraserCursor: () => {},
		// The pointercancel teardown's reach past the selection (cancelFingerInkForPinch): none is the subject.
		stopFrameTicker: () => {}, contactEndedWithoutLift: () => {}, releaseHeldFontRef: () => {}, hidePenCursor: () => {},
		hideEraserCursor: () => {}, endSpaceSnapshot: () => null, selectionDeleteKeys: { reset: () => {} }, erasePieces: new Set(),
		erased: [], eraseFrom: [], snapChip: null,
		// penUp's page resume after the gesture (a stranded pan easing back): not the subject.
		resumeStrandedPan: () => false,
	});
	// An ink down clears the rig's recording tail before it draws the head: not the subject.
	Object.assign((r.overlay as unknown as { tail: object }).tail, { clear: () => {} });
	const o = r.overlay as unknown as {
		lassoMove(s: object[]): void;
		lassoUp(): void;
		lassoDown(s: object, input: string): void;
		selectionContactAt(w: { x: number; y: number }, input: string): string | null;
		lassoActive: boolean;
		dragTotal: unknown;
		dragFrom: unknown;
		attachPress: unknown;
		pinPress: unknown;
		lassoPts: unknown[];
		mode: string;
	};
	const proto = InkOverlayPlugin.prototype as unknown as { penDown(s: object, ev: object): void; penUp(ev?: object): void };
	const select = (ids: string[]) => {
		r.selection.selectExactly(ids);
		r.redraw();
	};
	const at = (id: string) => {
		const s = r.anchors.strokesFor(path, inlineInk.strokes(path)).find((x) => x.id === id)!;
		return { x: s.points[0]!.x, y: s.points[0]!.y };
	};
	return { ...r, o, proto, select, at, wetDowns, path };
}

/** The real router on a fake scroller, wired to the rig's overlay. `fingerInk` arms iPhone finger ink. */
function routerOn(r: ReturnType<typeof dragRig>, opts: { fingerInk?: boolean } = {}) {
	const win = {
		devicePixelRatio: 1,
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
	};
	const el = Object.assign(fakeEl(), { scrollWidth: 800, clientWidth: 800, scrollHeight: 3600, clientHeight: 600, ownerDocument: { defaultView: win } });
	const rec = recorder();
	const downs: { x: number; y: number }[] = [], lifts: unknown[] = [], pinches: string[] = [];
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
		...rec.cb,
		fingerInk: () => opts.fingerInk ?? false,
		penOff: () => false,
		claimTouch: (s: { x: number; y: number }) => r.o.selectionContactAt(r.camera.screenToWorld(s.x, s.y), "touch") !== null,
		onPenDown: (s: { x: number; y: number }, ev: object) => {
			downs.push({ x: s.x, y: s.y });
			r.proto.penDown.call(r.overlay, s, ev);
		},
		onPenRaw: (samples: object[]) => {
			if (r.o.mode === "lasso") r.o.lassoMove(samples);
		},
		onPenUp: (ev?: { type?: string }) => {
			// A pointercancel, or no event (a pen landing takes the finger's contact): the real penUp, as Lifecycle wires it.
			if (!ev || ev.type === "pointercancel") r.proto.penUp.call(r.overlay, ev);
			else if (r.o.mode === "lasso") {
				r.o.lassoUp();
				r.o.mode = "ink";
			}
		},
		onPinch: (phase: string) => void pinches.push(phase),
		onFingerInkCancelled: () => (r.overlay as unknown as { cancelFingerInkForPinch(): void }).cancelFingerInkForPinch(),
		onTapLift: (s: { x: number; y: number }, ev: object) => {
			const answer = (r.overlay as unknown as { tapReleasesSelection(s: object, ev?: object): unknown }).tapReleasesSelection(s, ev);
			lifts.push(answer);
			return answer;
		},
	} as never, () => 1);
	let t = 10;
	const prevented: string[] = [];
	type TouchOpts = { id?: number; width?: number; target?: object };
	const touch = (type: string, x: number, y: number, o: TouchOpts = {}) => {
		t += 16;
		const ev = penEvent(type, t, { pointerId: o.id ?? 31, pointerType: "touch", x, y, pressure: 0, buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1, isPrimary: (o.id ?? 31) === 31 }) as unknown as Record<string, unknown>;
		ev.preventDefault = () => void prevented.push(type);
		ev.stopPropagation = () => {};
		if (o.width !== undefined) ev.width = ev.height = o.width;
		if (o.target) ev.target = o.target;
		const h = el.handlers.get(type === "pointercancel" ? "pointercancel" : type) ?? (type === "pointercancel" ? el.handlers.get("pointerup") : undefined);
		if (!h) throw new Error(`missing handler ${type}`);
		h(ev as unknown as Event);
	};
	/** A real pen contact, pointer 41. */
	const pen = (type: string, x: number, y: number) => {
		t += 16;
		const ev = penEvent(type, t, { pointerId: 41, pointerType: "pen", x, y, pressure: 0.5, buttons: type === "pointerup" ? 0 : 1 }) as unknown as Record<string, unknown>;
		ev.preventDefault = () => {};
		ev.stopPropagation = () => {};
		const h = el.handlers.get(type);
		if (!h) throw new Error(`missing handler ${type}`);
		h(ev as unknown as Event);
	};
	return { router, el, touch, pen, downs, lifts, pinches, prevented };
}

/** A task checkbox under the finger, as Live Preview draws it: closest() finds it for the checkbox selector. */
const checkbox = { closest: (sel: string) => (sel.includes(".task-list-item-checkbox") ? checkbox : null) };

describe("a finger on the selection waits for the tap limit, then moves it", () => {
	it("past the tap limit the box moves by the whole delta from where the finger landed, and the page does not pan", () => {
		// Defect (1.5.0): a finger in a selected box pans the page; the box never moves.
		const r = dragRig("drag-box.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointermove", FREE.x + 3, FREE.y + 2);
			expect(h.downs, "inside the limit nothing is claimed").toEqual([]);
			expect(r.at("free"), "inside the limit the box stays").toEqual(before);
			h.touch("pointermove", FREE.x + TAP_MAX_MOVE_PX + 12, FREE.y + 6);
			expect(h.downs, "claimed past the limit, from where the finger landed").toEqual([FREE]);
			h.touch("pointermove", FREE.x + 40, FREE.y + 20);
			h.touch("pointerup", FREE.x + 40, FREE.y + 20);
			expect(r.at("free"), "the whole delta").toEqual({ x: before.x + 40, y: before.y + 20 });
			expect(h.el.scrollTop, "the page did not pan").toBe(0);
			expect(h.lifts, "a drag is never a tap").toEqual([]);
		} finally {
			h.router.dispose();
		}
	});

	it("a capture loss on an element under the finger, after the claim, does not end the drag: the box follows every move to the lift", () => {
		// A real touch is captured by the element it landed on; when that element loses the capture, the loss reaches the
		// scroller's listener with the element as its target. Only the scroller's own loss ends a finger's stroke.
		const r = dragRig("drag-loss.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointermove", FREE.x + TAP_MAX_MOVE_PX + 12, FREE.y + 6);
			expect(h.downs, "claimed past the limit").toEqual([FREE]);
			h.touch("lostpointercapture", FREE.x + TAP_MAX_MOVE_PX + 12, FREE.y + 6, { target: checkbox });
			expect(h.router.isStroking, "the element's loss leaves the stroke live").toBe(true);
			h.touch("pointermove", FREE.x + 40, FREE.y + 20);
			h.touch("pointermove", FREE.x + 80, FREE.y + 40);
			h.touch("pointerup", FREE.x + 80, FREE.y + 40);
			expect(r.at("free"), "the whole delta, every move after the loss").toEqual({ x: before.x + 80, y: before.y + 40 });
			expect(h.el.scrollTop, "the page did not pan").toBe(0);
			expect(h.lifts, "a drag is never a tap").toEqual([]);
		} finally {
			h.router.dispose();
		}
	});

	it("inside the tap limit a lift is today's tap: on a checkbox in an attached group's box it goes on to the checkbox, and the box stays", () => {
		const r = dragRig("drag-checkbox.md");
		r.select(G1);
		const before = r.at("c1");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", IN_G1.x, IN_G1.y);
			h.touch("pointermove", IN_G1.x + 3, IN_G1.y + 3);
			h.touch("pointerup", IN_G1.x + 3, IN_G1.y + 3, { target: checkbox });
			expect(h.downs, "nothing claimed").toEqual([]);
			expect(h.lifts, "one tap, not taken: it goes on to the checkbox").toEqual([false]);
			expect(h.prevented, "nothing kept from the checkbox").toEqual([]);
			expect(r.at("c1"), "the box stays").toEqual(before);
			expect([...r.selection.strokeIds].sort(), "the group stays selected").toEqual(G1);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: the same tap in the gap with no checkbox is taken, as today: kept from the text, the box stays", () => {
		const r = dragRig("drag-gap.md");
		r.select(G1);
		const before = r.at("c1");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", IN_G1.x, IN_G1.y);
			h.touch("pointerup", IN_G1.x, IN_G1.y);
			expect([h.downs, h.lifts], "[claims, taps]").toEqual([[], [true]]);
			expect(r.at("c1")).toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("iPhone with finger ink on: a drag in the box moves it and makes no ink", () => {
		// Defect (1.5.0): the finger-ink claim takes the finger at the down and inks over the selection.
		const r = dragRig("drag-iphone.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r, { fingerInk: true });
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			expect(h.downs, "no claim at the down").toEqual([]);
			h.touch("pointermove", FREE.x + 30, FREE.y);
			h.touch("pointerup", FREE.x + 30, FREE.y);
			expect(r.wetDowns, "no ink").toEqual([]);
			expect(r.at("free"), "the box moved").toEqual({ x: before.x + 30, y: before.y });
		} finally {
			h.router.dispose();
		}
	});

	it("a finger dragging a corner handle resizes the selection", () => {
		const r = dragRig("drag-handle.md");
		r.select(["free"]);
		const b = (r.overlay as unknown as { selectionBounds(): { x: number; y: number; width: number; height: number } }).selectionBounds();
		const handle = (r.overlay as unknown as { transformHandleAt(w: object, input: string): unknown });
		// The bottom-right corner square: find it along the box's corner diagonal.
		let corner: { x: number; y: number } | null = null;
		for (let d = 0; d < 40 && !corner; d++) {
			const p = { x: b.x + b.width + d, y: b.y + b.height + d };
			if (handle.transformHandleAt(p, "touch") !== null) corner = p;
		}
		expect(corner, "a corner square").not.toBeNull();
		const width = () => {
			const s = r.anchors.strokesFor(r.path, inlineInk.strokes(r.path)).find((x) => x.id === "free")!;
			return s.points[s.points.length - 1]!.x - s.points[0]!.x;
		};
		const w0 = width();
		// A resize rides the drag's picture (beginLassoSnapshot); the rig's stub returns none, which makes the grab a plain
		// drag. The real snapshot here, with its own reach into the paint stubbed.
		const lassoProto = InkOverlayPlugin.prototype as unknown as Record<string, unknown>;
		Object.assign(r.overlay, { beginLassoSnapshot: lassoProto.beginLassoSnapshot, endSpaceSnapshot: lassoProto.endSpaceSnapshot, paintedStrokeCount: 0, repaintQueued: true, dropExtentBuild: () => {}, scheduleRepaint: () => {} });
		const h = routerOn(r);
		try {
			h.touch("pointerdown", corner!.x, corner!.y);
			h.touch("pointermove", corner!.x + 40, corner!.y + 40);
			h.touch("pointerup", corner!.x + 40, corner!.y + 40);
			expect(width(), "wider").toBeGreaterThan(w0 + 10);
		} finally {
			h.router.dispose();
		}
	});
});

describe("guards: what a finger on the selection must not do", () => {
	it("a finger outside the box is the page's: no claim, the selection does not move", () => {
		const r = dragRig("guard-outside.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", 400, 500);
			h.touch("pointermove", 400, 450);
			h.touch("pointerup", 400, 450);
			expect(h.downs).toEqual([]);
			expect(r.at("free")).toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("iPhone with finger ink on: a finger outside the box inks, claimed at the down as today", () => {
		const r = dragRig("guard-iphone-outside.md");
		r.select(["free"]);
		const h = routerOn(r, { fingerInk: true });
		try {
			h.touch("pointerdown", 400, 500);
			expect(h.downs, "claimed at the down").toEqual([{ x: 400, y: 500 }]);
			expect(r.o.mode, "an ink contact, not the selection's").not.toBe("lasso");
		} finally {
			h.router.dispose();
		}
	});

	it("a second finger after the claim is a pinch: the box goes back where it started", () => {
		const r = dragRig("guard-pinch-after.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointermove", FREE.x + 30, FREE.y);
			expect(r.at("free").x, "moving").toBe(before.x + 30);
			h.touch("pointerdown", 400, 400, { id: 32 });
			expect(r.at("free"), "back where it started").toEqual(before);
			// The router starts the pinch on the first move that spreads the pair (pinchEngaged), not at the second down.
			h.touch("pointermove", 460, 460, { id: 32 });
			expect(h.pinches, "a pinch").toContain("start");
			expect(r.at("free"), "still where it started").toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("a second finger before the tap limit is a pinch: nothing is claimed and the box stays", () => {
		const r = dragRig("guard-pinch-before.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointerdown", 400, 400, { id: 32 });
			h.touch("pointermove", FREE.x + 30, FREE.y);
			expect(h.downs).toEqual([]);
			expect(h.pinches).toContain("start");
			expect(r.at("free")).toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("the palm gate comes first: a finger it blocks on the box moves nothing", () => {
		const r = dragRig("guard-palm.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			(h.router as unknown as { anyGateBlocksNewTouch: () => boolean }).anyGateBlocksNewTouch = () => true;
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointermove", FREE.x + 30, FREE.y);
			h.touch("pointerup", FREE.x + 30, FREE.y);
			expect(h.downs).toEqual([]);
			expect(r.at("free")).toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("a palm-sized contact on the box is not the selection's: it moves nothing", () => {
		const r = dragRig("guard-size.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y, { width: 80 });
			h.touch("pointermove", FREE.x + 30, FREE.y, { width: 80 });
			h.touch("pointerup", FREE.x + 30, FREE.y, { width: 80 });
			expect(h.downs).toEqual([]);
			expect(r.at("free")).toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: a fingertip-sized contact on the box is the selection's", () => {
		const r = dragRig("guard-size-small.md");
		r.select(["free"]);
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y, { width: 20 });
			h.touch("pointermove", FREE.x + 30, FREE.y, { width: 20 });
			expect(h.downs).toEqual([FREE]);
		} finally {
			h.router.dispose();
		}
	});

	it("a pointercancel mid drag puts the box back where it started and records no step", () => {
		const r = dragRig("guard-cancel.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointermove", FREE.x + 30, FREE.y + 10);
			expect(r.at("free"), "moving").toEqual({ x: before.x + 30, y: before.y + 10 });
			const sent = r.sent.length;
			h.touch("pointercancel", FREE.x + 30, FREE.y + 10);
			expect(r.at("free"), "back").toEqual(before);
			expect(r.sent.length, "no history step").toBe(sent);
			expect(r.o.mode).toBe("ink");
		} finally {
			h.router.dispose();
		}
	});
});

describe("a pen landing while a finger holds the selection is a cancel", () => {
	const PEN_AWAY = { x: 400, y: 500 };
	const record = (r: ReturnType<typeof dragRig>) => JSON.stringify(inlineInk.attachments(r.path));
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};

	it("a finger box drag, then the pen lands: the box goes back where it started", () => {
		const r = dragRig("pen-lands-box.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.touch("pointermove", FREE.x + 30, FREE.y + 10);
			expect(r.at("free"), "moving").toEqual({ x: before.x + 30, y: before.y + 10 });
			h.pen("pointerdown", PEN_AWAY.x, PEN_AWAY.y);
			expect(r.at("free"), "back").toEqual(before);
		} finally {
			h.router.dispose();
		}
	});

	it("a finger on a pin, past the pad, then the pen lands: the hook and the saved record stay", async () => {
		const r = dragRig("pen-lands-pin.md");
		r.select(G1);
		const pin = attachPinsOf(r.overlay as never, inlineInk.attachments(r.path), inlineInk.strokes(r.path), inlineInk.generation(r.path))[0]!;
		const saved = record(r);
		const h = routerOn(r);
		try {
			h.touch("pointerdown", pin.at.x, pin.at.y - 13);
			h.touch("pointermove", pin.at.x + 40, pin.at.y + 30);
			h.touch("pointermove", pin.at.x + 80, pin.at.y + 120);
			expect((r.o.pinPress as { moved?: boolean } | null)?.moved, "the finger works the pin, past the pad").toBe(true);
			h.pen("pointerdown", PEN_AWAY.x, PEN_AWAY.y);
			expect(r.o.pinPress, "no pin press left").toBeNull();
			// A pin's drop writes after a measure and a microtask: read the record once it could have written.
			await settle();
			expect(record(r), "the hook and the saved record stay").toBe(saved);
		} finally {
			h.router.dispose();
		}
	});

	it("CONTROL: the same finger pin drag lifted with a pointerup re-hooks, read after a settle", async () => {
		const r = dragRig("pin-lift-settle.md");
		r.select(G1);
		const pin = attachPinsOf(r.overlay as never, inlineInk.attachments(r.path), inlineInk.strokes(r.path), inlineInk.generation(r.path))[0]!;
		const saved = record(r);
		const h = routerOn(r);
		try {
			h.touch("pointerdown", pin.at.x, pin.at.y - 13);
			h.touch("pointermove", pin.at.x + 40, pin.at.y + 30);
			h.touch("pointermove", pin.at.x + 80, pin.at.y + 120);
			h.touch("pointerup", pin.at.x + 80, pin.at.y + 120);
			await settle();
			expect(record(r), "a lifted drop re-hooks").not.toBe(saved);
		} finally {
			h.router.dispose();
		}
	});

	it("the button's grab pad is the tap limit: a finger on the Attach button past the limit lets it go, so a pen landing then attaches nothing", async () => {
		// The press pad and the router's tap limit are one distance: a finger is claimed on the button only once it is past
		// the limit, so it is already past the pad and the press is let go. A pad wider than the limit would hold the press.
		expect(SELECTION_GRAB_PAD, "the pad is the tap limit").toBe(TAP_MAX_MOVE_PX);
		const r = dragRig("button-past-limit.md");
		r.select(G1);
		const b = attachButtonPoint((r.overlay as unknown as { selectionBounds(): Bounds }).selectionBounds()!, 1, 1);
		const saved = record(r);
		const h = routerOn(r);
		try {
			h.touch("pointerdown", b.x, b.y);
			h.touch("pointermove", b.x + TAP_MAX_MOVE_PX + 4, b.y);
			expect(h.downs, "claimed past the limit").toEqual([b]);
			expect((r.o.attachPress as { cancelled?: boolean } | null)?.cancelled, "the press is let go").toBe(true);
			h.pen("pointerdown", PEN_AWAY.x, PEN_AWAY.y);
			h.pen("pointerup", PEN_AWAY.x, PEN_AWAY.y);
			h.touch("pointerup", b.x + TAP_MAX_MOVE_PX + 4, b.y);
			await settle();
			expect(record(r), "the attach list and the saved record stay").toBe(saved);
		} finally {
			h.router.dispose();
		}
	});

	it("a finger down on the Attach button, then the pen lands, then the finger lifts: the attach list stays", () => {
		const r = dragRig("pen-lands-button.md");
		r.select(G1);
		const b = attachButtonPoint((r.overlay as unknown as { selectionBounds(): Bounds }).selectionBounds()!, 1, 1);
		const saved = record(r);
		const h = routerOn(r);
		try {
			h.touch("pointerdown", b.x, b.y);
			h.pen("pointerdown", PEN_AWAY.x, PEN_AWAY.y);
			h.pen("pointerup", PEN_AWAY.x, PEN_AWAY.y);
			h.touch("pointerup", b.x, b.y);
			expect(record(r), "the attach list and the saved record stay").toBe(saved);
		} finally {
			h.router.dispose();
		}
	});

	it("a finger waiting on the box, then the pen lands outside it and stays down, then the finger passes the limit: the pen keeps its stroke", () => {
		// A palm on the box while the pen writes beside it. Defect (B at ada8e3d7): the finger is claimed past the limit,
		// takes the contact from the live pen and inks.
		const r = dragRig("wait-pen-lands.md");
		r.select(["free"]);
		const h = routerOn(r);
		const active = () => (h.router as unknown as { activePenId: number | null }).activePenId;
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.pen("pointerdown", PEN_AWAY.x, PEN_AWAY.y);
			expect(h.downs, "the pen's down").toEqual([PEN_AWAY]);
			const inked = r.wetDowns.length;
			h.touch("pointermove", FREE.x + 30, FREE.y);
			h.touch("pointermove", FREE.x + 60, FREE.y);
			expect(h.downs, "nothing claimed for the finger").toEqual([PEN_AWAY]);
			expect(active(), "the pen keeps its contact").toBe(41);
			expect(r.wetDowns.length, "no finger ink").toBe(inked);
		} finally {
			h.router.dispose();
		}
	});

	it("a finger waiting on the box, then the pen lands inside the box and stays down, then the finger passes the limit: the pen's drag goes on and the box ends where the pen puts it", () => {
		// The pen on the selection keeps it, so the claim test alone still says yes for the finger: only the live pen stops it.
		const PEN_IN = { x: 140, y: 262 };
		const r = dragRig("wait-pen-lands-inside.md");
		r.select(["free"]);
		const before = r.at("free");
		const h = routerOn(r);
		const active = () => (h.router as unknown as { activePenId: number | null }).activePenId;
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			h.pen("pointerdown", PEN_IN.x, PEN_IN.y);
			expect(h.downs, "the pen's down").toEqual([PEN_IN]);
			expect(r.o.selectionContactAt(r.camera.screenToWorld(FREE.x, FREE.y), "touch"), "the finger is still on the selection").not.toBeNull();
			h.touch("pointermove", FREE.x + 30, FREE.y);
			h.touch("pointermove", FREE.x + 60, FREE.y);
			expect(h.downs, "nothing claimed for the finger").toEqual([PEN_IN]);
			expect(active(), "the pen keeps its contact").toBe(41);
			h.pen("pointermove", PEN_IN.x + 20, PEN_IN.y + 15);
			h.pen("pointerup", PEN_IN.x + 20, PEN_IN.y + 15);
			h.touch("pointerup", FREE.x + 60, FREE.y);
			expect(r.wetDowns, "no ink").toEqual([]);
			expect(r.at("free"), "the box ends where the pen puts it").toEqual({ x: before.x + 20, y: before.y + 15 });
		} finally {
			h.router.dispose();
		}
	});

	it("the selection clears while a finger waits on it, then the finger passes the limit: no ink, no claim", () => {
		const r = dragRig("wait-selection-clears.md");
		r.select(["free"]);
		const h = routerOn(r);
		try {
			h.touch("pointerdown", FREE.x, FREE.y);
			r.selection.clear();
			r.redraw();
			h.touch("pointermove", FREE.x + 30, FREE.y);
			h.touch("pointermove", FREE.x + 60, FREE.y);
			h.touch("pointerup", FREE.x + 60, FREE.y);
			expect(h.downs, "nothing claimed").toEqual([]);
			expect(r.wetDowns, "no ink").toEqual([]);
			expect(r.o.mode, "no lasso contact").not.toBe("lasso");
		} finally {
			h.router.dispose();
		}
	});
});

describe("with the toolbar lasso on, a finger box drag taken, not lifted, goes back", () => {
	// Picking the toolbar lasso to make a selection leaves it on, so this is the usual case on a tablet.
	const PEN_AWAY = { x: 400, y: 500 };
	const lassoOn = <T>(fn: () => T): T => {
		setTipMode("lasso");
		try {
			return fn();
		} finally {
			setTipMode("nib");
		}
	};

	it("CONTROL: with the toolbar lasso on, a finger past the limit moves the box", () =>
		lassoOn(() => {
			const r = dragRig("lasso-tip-control.md");
			r.select(["free"]);
			const before = r.at("free");
			const h = routerOn(r);
			try {
				h.touch("pointerdown", FREE.x, FREE.y);
				h.touch("pointermove", FREE.x + 30, FREE.y + 10);
				expect(h.downs, "claimed past the limit").toEqual([FREE]);
				expect(r.at("free"), "moving").toEqual({ x: before.x + 30, y: before.y + 10 });
			} finally {
				h.router.dispose();
			}
		}));

	it("a pointercancel mid finger drag puts the box back and records no step", () =>
		lassoOn(() => {
			const r = dragRig("lasso-tip-cancel.md");
			r.select(["free"]);
			const before = r.at("free");
			const h = routerOn(r);
			try {
				h.touch("pointerdown", FREE.x, FREE.y);
				h.touch("pointermove", FREE.x + 30, FREE.y + 10);
				expect(r.at("free"), "moving").toEqual({ x: before.x + 30, y: before.y + 10 });
				const sent = r.sent.length;
				h.touch("pointercancel", FREE.x + 30, FREE.y + 10);
				expect(r.at("free"), "back").toEqual(before);
				expect(r.sent.length, "no history step").toBe(sent);
			} finally {
				h.router.dispose();
			}
		}));

	it("a pen landing mid finger drag puts the box back", () =>
		lassoOn(() => {
			const r = dragRig("lasso-tip-pen.md");
			r.select(["free"]);
			const before = r.at("free");
			const h = routerOn(r);
			try {
				h.touch("pointerdown", FREE.x, FREE.y);
				h.touch("pointermove", FREE.x + 30, FREE.y + 10);
				expect(r.at("free"), "moving").toEqual({ x: before.x + 30, y: before.y + 10 });
				h.pen("pointerdown", PEN_AWAY.x, PEN_AWAY.y);
				expect(r.at("free"), "back").toEqual(before);
			} finally {
				h.router.dispose();
			}
		}));

	// The pen's own box drag is not the finger's: a pointercancel or a window blur (no event) ends it where the pen put it.
	for (const end of ["pointercancel", "blur"] as const) {
		it(`a pen box drag ended by ${end === "blur" ? "a window blur (no event)" : "a pointercancel"}: the box stays where the pen put it and the move is committed`, () =>
			lassoOn(() => {
				const r = dragRig(`lasso-tip-pen-drag-${end}.md`);
				r.select(["free"]);
				const before = r.at("free");
				const h = routerOn(r);
				try {
					h.pen("pointerdown", FREE.x, FREE.y);
					expect(r.o.mode, "premise: the pen's contact is the lasso's").toBe("lasso");
					h.pen("pointermove", FREE.x + 30, FREE.y + 10);
					expect(r.at("free"), "moving").toEqual({ x: before.x + 30, y: before.y + 10 });
					const sent = r.sent.length;
					// A blur reaches the overlay as penUp with no event (the router's onPenUp(), wired here as Lifecycle wires it).
					if (end === "pointercancel") h.pen("pointercancel", FREE.x + 30, FREE.y + 10);
					else r.proto.penUp.call(r.overlay);
					expect(r.at("free"), "the box stays where the pen put it").toEqual({ x: before.x + 30, y: before.y + 10 });
					expect(r.sent.length, "the move is committed as a step").toBeGreaterThan(sent);
				} finally {
					h.router.dispose();
				}
			}));
	}
});

describe("one hit test: the claim and the contact agree", () => {
	it("across the box, its pad, the handles and the button, the claim says yes exactly where the lasso contact takes no loop", () => {
		const r = dragRig("one-test.md");
		const wrong: string[] = [];
		for (let y = 200; y <= 340; y += 4) {
			for (let x = -30; x <= 210; x += 4) {
				r.select(["free"]);
				const claim = r.o.selectionContactAt(r.camera.screenToWorld(x, y), "touch") !== null;
				r.o.lassoDown({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, "touch");
				const contact = !r.o.lassoActive;
				if (claim !== contact) wrong.push(`${x},${y} claim ${claim} contact ${contact}`);
				Object.assign(r.o, { lassoActive: false, lassoPts: [], dragTotal: null, dragFrom: null, attachPress: null, pinPress: null, dragBox: null });
			}
		}
		expect(wrong).toEqual([]);
	});

	it("CONTROL: the grid reaches both answers", () => {
		const r = dragRig("one-test-control.md");
		r.select(["free"]);
		const at = (x: number, y: number) => r.o.selectionContactAt(r.camera.screenToWorld(x, y), "touch");
		expect([at(FREE.x, FREE.y), at(400, 500)]).toEqual(["box", null]);
	});
});
